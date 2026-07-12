const fs = require('fs');
let code = fs.readFileSync('src/components/ProblemConfigModal.tsx', 'utf8');

code = code.replace(/next\.tests\[tName\]/g, "next.tests[tName as string]");
code = code.replace(/next\.tests\[tc\.name\]/g, "next.tests[tc.name as string]");
code = code.replace(/polyData\.tests\[tc\.name\]/g, "polyData.tests[tc.name as string]");

fs.writeFileSync('src/components/ProblemConfigModal.tsx', code);
