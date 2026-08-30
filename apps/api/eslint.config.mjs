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
          ],
        },
      ],
    },
  },
];
