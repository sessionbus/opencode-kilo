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
    },
  },
  events: {},
};
