// SPDX-License-Identifier: MIT
package opencodefamily

import (
	"context"
	"errors"
	"os"
	"syscall"

	kit "github.com/antst/sessionbus/bus/sdk/go"
)

// stopKiloChild only requests termination; it never joins the monitor that may
// itself call it. Ordinary owner cancellation is not forced termination.
func (p *Wrapper) stopKiloChild(force bool) {
	p.mu.Lock()
	cmd, output := p.command, p.output
	p.mu.Unlock()
	if cmd == nil {
		return
	}
	stop := func(signal os.Signal) {
		if err := cmd.Process.Signal(signal); err != nil && !errors.Is(err, os.ErrProcessDone) {
			p.mu.Lock()
			p.stopErr = errors.Join(p.stopErr, err)
			p.mu.Unlock()
		}
	}
	if force {
		p.forceOnce.Do(func() {
			stop(os.Kill)
			// Forced cleanup has no buffered-output or descendant-drain claim.
			if output != nil {
				_ = output.Close()
			}
		})
	} else {
		p.termOnce.Do(func() { stop(syscall.SIGTERM) })
	}
}

func (p *Wrapper) closeKiloEndpoint() {
	if p.endpoint != nil {
		if err := p.endpoint.Close(); err != nil {
			p.mu.Lock()
			p.stopErr = errors.Join(p.stopErr, err)
			p.mu.Unlock()
		}
	}
}

// This is the existing owner's monitor, not a second supervisor. It releases
// local calls before joining native cleanup; the process waiter and output
// reader remain independent members of workers. It never invokes joined Close.
func (p *Wrapper) monitorKilo() {
	<-p.ctx.Done()
	p.mu.Lock()
	adopted, done := p.opened, p.childDone
	p.mu.Unlock()
	p.stopKiloChild(!adopted)
	p.closeKiloEndpoint()
	if done != nil {
		<-done
	}
	p.mu.Lock()
	run := p.run
	p.mu.Unlock()
	if run != nil {
		<-run.Done()
		p.clearRun(run)
	}
	p.mu.Lock()
	closing, shutdown := p.closing, p.shutdown
	p.mu.Unlock()
	if adopted && !closing && shutdown != nil {
		p.retire(shutdown)
	}
}

func (p *Wrapper) closeKilo(ctx context.Context, request kit.SessionCloseRequest) error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closing = true
		cancel, adopted := p.cancel, p.opened
		p.mu.Unlock()

		// Only the supplied Close context authorizes escalation during a normal
		// close. Internal cancellation below must not activate this callback.
		escalated := make(chan struct{})
		stopEscalation := context.AfterFunc(ctx, func() {
			p.stopKiloChild(true)
			if cancel != nil {
				cancel(context.Cause(ctx))
			}
			close(escalated)
		})
		p.stopKiloChild(!adopted)
		if cancel != nil {
			cancel(errors.New("Kilo owner closing"))
		}
		p.closeKiloEndpoint()
		p.workers.Wait()
		if !stopEscalation() {
			<-escalated
		}
		p.mu.Lock()
		p.closeErr = errors.Join(p.closeErr, p.stopErr, p.childErr, context.Cause(ctx))
		p.mu.Unlock()
	})
	return p.closeErr
}
