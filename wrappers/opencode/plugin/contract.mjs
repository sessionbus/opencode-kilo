// SPDX-License-Identifier: MIT

// Native RPC contract between this package's TUI and server entries.
export const contract = {
  id: "sessionbus",
  methods: {
    activate: {
      input: {
        type: "object",
        additionalProperties: false,
        required: ["sessionID", "socket", "groups"],
        properties: {
          sessionID: { type: "string" },
          socket: { type: "string" },
          name: { type: "string" },
          groups: { type: "array", items: { type: "string" } },
        },
      },
      output: { type: "object" },
      // The bus has not admitted the session yet; its Peer keeps connecting.
      // A lane holds the session: the TUI stops activating it.
      errors: { "sessionbus.not_admitted": { type: "object" }, "sessionbus.conflict": { type: "object" } },
    },
    // A Sessionbus lane worker binds its session's tool to the worker's
    // private endpoint before each Run.
    lane: {
      input: {
        type: "object",
        additionalProperties: false,
        required: ["sessionID", "socket"],
        properties: {
          sessionID: { type: "string" },
          socket: { type: "string" },
        },
      },
      output: { type: "object" },
      // Another holder (a managed TUI's Peer or another lane) has the session.
      errors: { "sessionbus.conflict": { type: "object" } },
    },
  },
  events: {},
};
