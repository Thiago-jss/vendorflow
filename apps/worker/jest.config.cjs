module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: "tsconfig.json" }]
  },
  testEnvironment: "node",
  // Integration tests drive real containers, a real broker and a real retry ladder. The
  // 5-second default is a unit-test budget and would fail them on the clock rather than on
  // behaviour.
  testTimeout: 60_000
};
