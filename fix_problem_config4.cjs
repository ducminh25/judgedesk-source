const fs = require('fs');
let code = fs.readFileSync('src/components/ProblemConfigModal.tsx', 'utf8');

code = code.replace(/testDetails\.reduce\(\(sum, t\) => sum \+ \(polyData\.tests\[t\.name\]\?\.points \|\| 0\), 0\)/g, "testDetails.reduce((sum, t) => sum + ((polyData.tests[t.name] as any)?.points || 0), 0)");
code = code.replace(/testDetails\.filter\(t => polyData\.tests\[t\.name\]\?\.group === g\)/g, "testDetails.filter(t => (polyData.tests[t.name] as any)?.group === g)");
code = code.replace(/reduce\(\(sum, t\) => sum \+ \(polyData\.tests\[t\.name\]\?\.points \|\| 0\), 0\)/g, "reduce((sum, t) => sum + ((polyData.tests[t.name] as any)?.points || 0), 0)");

fs.writeFileSync('src/components/ProblemConfigModal.tsx', code);
