const fs = require('fs');
let code = fs.readFileSync('src/components/ProblemConfigModal.tsx', 'utf8');

code = code.replaceAll('polyData.tests[tc.name]', '(polyData.tests[tc.name] as any)');
code = code.replaceAll('polyData.tests[tName]', '(polyData.tests[tName] as any)');
code = code.replaceAll('polyData.tests[tName as string]', '(polyData.tests[tName as string] as any)');

fs.writeFileSync('src/components/ProblemConfigModal.tsx', code);
