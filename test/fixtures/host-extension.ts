/**
 * A static host extension for ae-test's own tests.
 *
 * The shape is `HostExtension` from `specs/isolated-ae/contracts/extensions.md`
 * in ae-a8n. It is declared here, in the consumer, and built into a host script
 * by `ae-a8n extension build` before a session starts; nothing here is
 * evaluated by the Node process at call time.
 *
 * The method body is an ES3 function expression: no `let`/`const`, arrows,
 * template literals, or `JSON`. It receives the decoded params object and its
 * return value goes back through the host's JSON codec.
 */

const extension = {
  name: "aetest",
  version: "1.0.0",
  methods: [
    {
      name: "aetest.add",
      source: "function (params) { return params.a + params.b; }",
    },
  ],
} as const;

export default extension;
