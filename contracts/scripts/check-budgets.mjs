import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const contracts = fileURLToPath(new URL('../', import.meta.url));
const aiken = fileURLToPath(new URL('../../node_modules/.bin/aiken', import.meta.url));
const budgetsFile = new URL('../budgets.json', import.meta.url);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUnits = value => Number.isSafeInteger(value) && value >= 0;

function readBudgets() {
  const config = JSON.parse(readFileSync(budgetsFile, 'utf8'));
  if (!isObject(config) || Object.keys(config).length === 0) {
    throw new Error('Budget configuration must name at least one test.');
  }
  const entries = [];
  for (const [module, tests] of Object.entries(config)) {
    if (!isObject(tests) || Object.keys(tests).length === 0) {
      throw new Error(`Budget module ${module} must name at least one test.`);
    }
    for (const [title, bounds] of Object.entries(tests)) {
      const name = `${module}.${title}`;
      if (!isObject(bounds) || Object.keys(bounds).length === 0 ||
          Object.entries(bounds).some(([unit, value]) =>
            !['cpu', 'mem'].includes(unit) || !isUnits(value))) {
        throw new Error(`${name} has invalid bounds. Use nonnegative integer cpu or mem bounds.`);
      }
      entries.push({ name, bounds });
    }
  }
  return entries;
}

function checkBudgets() {
  const entries = readBudgets();
  // A pipe makes Aiken emit JSON. Resolve both paths independently of cwd and PATH.
  const run = spawnSync(aiken, ['check'], {
    cwd: contracts,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.stderr) process.stderr.write(run.stderr);
  const failures = [];
  if (run.error) failures.push(`aiken check could not run: ${run.error.message}`);
  if (run.status !== 0) {
    failures.push(`aiken check exited with status ${run.status ?? run.signal ?? 'unknown'}.`);
  }

  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch (error) {
    failures.push(`Cannot read aiken check JSON: ${error.message}`);
  }
  const tests = new Map();
  if (report) {
    if (!isUnits(report.summary?.failed) || !Array.isArray(report.modules)) {
      failures.push('aiken check JSON is missing its summary or modules.');
    } else {
      if (report.summary.failed !== 0) {
        failures.push(`aiken check reports ${report.summary.failed} failed tests.`);
      }
      for (const module of report.modules) {
        if (typeof module.name !== 'string' || !Array.isArray(module.tests)) {
          failures.push('aiken check JSON contains an invalid module.');
          continue;
        }
        for (const test of module.tests) {
          const name = `${module.name}.${test.title}`;
          if (tests.has(name)) failures.push(`${name} occurs more than once.`);
          tests.set(name, test);
          // A failing test outside the budget list must still fail this command.
          if (test.status !== 'pass') failures.push(`${name} failed (${test.status}).`);
        }
      }
    }
  }

  for (const { name, bounds } of entries) {
    const test = tests.get(name);
    const costs = test?.execution_units;
    const reasons = [];
    if (!test) reasons.push('missing test');
    else if (test.status !== 'pass') reasons.push('test failed');
    if (test && (!isUnits(costs?.cpu) || !isUnits(costs?.mem))) {
      reasons.push('missing or invalid execution costs');
    }
    for (const [unit, limit] of Object.entries(bounds)) {
      if (isUnits(costs?.[unit]) && costs[unit] > limit) reasons.push(`${unit} exceeds bound`);
    }
    const status = reasons.length === 0 ? 'OK' : `OVER (${reasons.join(', ')})`;
    console.log(`${name} cpu=${costs?.cpu ?? 'n/a'} mem=${costs?.mem ?? 'n/a'} ` +
      `bounds(cpu=${bounds.cpu ?? 'none'}, mem=${bounds.mem ?? 'none'}) ${status}`);
    if (reasons.length) failures.push(`${name}: ${reasons.join(', ')}.`);
  }
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

try {
  checkBudgets();
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
