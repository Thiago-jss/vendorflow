import config from "@vendorflow/eslint-config";

export default [
  ...config,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message:
                "Use @vendorflow/database from an explicit persistence adapter.",
            },
            {
              name: "amqplib",
              message:
                "The API never talks to a broker. Record an outgoing fact through platform's outbox capability; publishing belongs to the worker (ADR-003).",
            },
          ],
        },
      ],
    },
  },
];
