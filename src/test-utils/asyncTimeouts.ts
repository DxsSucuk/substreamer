/**
 * Async waiting budgets for the suite.
 *
 * RNTL's 1000ms default is too tight here: the screen suites do real SQLite I/O through the
 * better-sqlite3 seam, then a React effect, then a re-read — and they run against ~476 parallel
 * suites. Two of them failed intermittently at 1000ms while passing alone.
 *
 * `testTimeout` must stay comfortably above `asyncUtilTimeout`, or an exhausted `waitFor` races
 * jest's own timeout and reports "Exceeded timeout of Nms for a test" instead of RNTL's error
 * showing what it waited for and what it found.
 *
 * Must run in `setupFilesAfterEnv`, not `setupFiles`: the latter runs before the test framework
 * and pulls react-native into every suite, including the pure repository ones.
 */
import { configure } from '@testing-library/react-native';

configure({ asyncUtilTimeout: 5000 });
jest.setTimeout(15000);
