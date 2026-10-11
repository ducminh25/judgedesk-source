import fs from 'node:fs';
import path from 'node:path';

const stressRoot = process.env.STRESS_TEST_ROOT || path.resolve(process.cwd(), "../stress_test_judge");
const serverUrl = process.env.JUDGEDESK_SERVER_URL || "http://127.0.0.1:3000";

console.log("Sending batch-judge request for AC_cpp / A_plus_B...");
const startTime = Date.now();

try {
  const response = await fetch(`${serverUrl}/api/batch-judge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thisinhPath: path.join(stressRoot, "contestants"),
      testPath: path.join(stressRoot, "test"),
      jobId: `debug_${Date.now()}`,
      problemConfigs: {},
      targetContestants: ["AC_cpp"],
      targetProblems: ["A_plus_B"],
    }),
  });

  console.log(`HTTP status: ${response.status}`);
  const text = await response.text();
  console.log(`Response text (${Date.now() - startTime}ms):\n`, text);
} catch (e: any) {
  console.error("Fetch error:", e);
}
