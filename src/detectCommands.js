import fs from "node:fs";
import path from "node:path";

function exists(workspace, filePath) {
  return fs.existsSync(path.join(workspace, filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function detectPackageManager(workspace) {
  if (exists(workspace, "pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (exists(workspace, "yarn.lock")) {
    return "yarn";
  }
  if (exists(workspace, "bun.lockb") || exists(workspace, "bun.lock")) {
    return "bun";
  }
  return "npm";
}

function scriptCommand(packageManager, script) {
  if (packageManager === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  if (packageManager === "pnpm") {
    return script === "test" ? "pnpm test" : `pnpm run ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn run ${script}`;
  }
  if (packageManager === "bun") {
    return `bun run ${script}`;
  }
  return `npm run ${script}`;
}

function isPlaceholderTest(scriptValue) {
  return /no test specified|error: no test/i.test(scriptValue);
}

function detectNodeCommands(workspace) {
  const packageJsonPath = path.join(workspace, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return { test: [], verify: [], reasons: [] };
  }

  const packageJson = readJson(packageJsonPath);
  const scripts = packageJson.scripts || {};
  const packageManager = detectPackageManager(workspace);
  const testCandidates = ["test:ci", "test", "test:unit", "test:all"];
  const verifyCandidates = [
    "check",
    "lint",
    "typecheck",
    "type-check",
    "tsc",
    "build",
    "test:types"
  ];

  const testScript = testCandidates.find(
    (name) => scripts[name] && !isPlaceholderTest(scripts[name])
  );

  return {
    test: testScript ? [scriptCommand(packageManager, testScript)] : [],
    verify: verifyCandidates
      .filter((name) => scripts[name] && !isPlaceholderTest(scripts[name]))
      .map((name) => scriptCommand(packageManager, name)),
    reasons: [`package.json scripts via ${packageManager}`]
  };
}

function detectPythonCommands(workspace) {
  const hasPythonProject =
    exists(workspace, "pyproject.toml") ||
    exists(workspace, "setup.py") ||
    exists(workspace, "setup.cfg") ||
    exists(workspace, "requirements.txt");
  const hasPytestConfig =
    exists(workspace, "pytest.ini") ||
    exists(workspace, "tox.ini") ||
    exists(workspace, "conftest.py") ||
    exists(workspace, "tests");

  if (!hasPythonProject && !hasPytestConfig) {
    return { test: [], verify: [], reasons: [] };
  }

  const test = hasPytestConfig ? ["python -m pytest"] : [];
  return {
    test,
    verify: hasPythonProject ? ["python -m compileall ."] : [],
    reasons: ["Python project files"]
  };
}

function detectRustCommands(workspace) {
  if (!exists(workspace, "Cargo.toml")) {
    return { test: [], verify: [], reasons: [] };
  }

  return {
    test: ["cargo test"],
    verify: ["cargo check"],
    reasons: ["Cargo.toml"]
  };
}

function detectGoCommands(workspace) {
  if (!exists(workspace, "go.mod")) {
    return { test: [], verify: [], reasons: [] };
  }

  return {
    test: ["go test ./..."],
    verify: ["go vet ./..."],
    reasons: ["go.mod"]
  };
}

function detectJavaCommands(workspace) {
  if (exists(workspace, "pom.xml")) {
    return {
      test: ["mvn test"],
      verify: [],
      reasons: ["pom.xml"]
    };
  }

  if (exists(workspace, "gradlew")) {
    return {
      test: ["./gradlew test"],
      verify: [],
      reasons: ["gradlew"]
    };
  }

  if (exists(workspace, "build.gradle") || exists(workspace, "build.gradle.kts")) {
    return {
      test: ["gradle test"],
      verify: [],
      reasons: ["Gradle build file"]
    };
  }

  return { test: [], verify: [], reasons: [] };
}

function detectOtherCommands(workspace) {
  if (exists(workspace, "mix.exs")) {
    return {
      test: ["mix test"],
      verify: [],
      reasons: ["mix.exs"]
    };
  }

  if (exists(workspace, "Gemfile") && exists(workspace, "spec")) {
    return {
      test: ["bundle exec rspec"],
      verify: [],
      reasons: ["Gemfile and spec directory"]
    };
  }

  return { test: [], verify: [], reasons: [] };
}

export function detectProjectCommands(workspace) {
  const detections = [
    detectNodeCommands(workspace),
    detectPythonCommands(workspace),
    detectRustCommands(workspace),
    detectGoCommands(workspace),
    detectJavaCommands(workspace),
    detectOtherCommands(workspace)
  ];

  return {
    test: unique(detections.flatMap((detection) => detection.test)),
    verify: unique(detections.flatMap((detection) => detection.verify)),
    reasons: unique(detections.flatMap((detection) => detection.reasons))
  };
}

export function resolveVerificationCommands(config, plan, detected = detectProjectCommands(config.workspace)) {
  const explicitTest = config.commands.test || [];
  const explicitVerify = config.commands.verify || [];
  const usePlannerCommands = config.allowPlannerCommandOverride;
  const test = usePlannerCommands && plan.testCommands?.length ? plan.testCommands : explicitTest;
  const verify =
    usePlannerCommands && plan.verifyCommands?.length ? plan.verifyCommands : explicitVerify;
  const resolvedTest = test.length ? test : detected.test;
  const resolvedVerify = verify.length ? verify : detected.verify;
  const fallbackVerify = config.commandDiscovery?.fallbackVerifyCommands || ["git diff --check"];
  const requireTests = config.commandDiscovery?.requireTests !== false;
  const hasRunnableTests = resolvedTest.length > 0;

  return {
    test: resolvedTest,
    verify: unique([...resolvedVerify, ...fallbackVerify]),
    detected,
    requireTests,
    hasRunnableTests,
    needsTestCreation: requireTests && !hasRunnableTests,
    source: {
      test: test.length ? "config" : "auto",
      verify: verify.length ? "config" : "auto"
    }
  };
}
