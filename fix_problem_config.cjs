const fs = require('fs');
let code = fs.readFileSync('src/components/ProblemConfigModal.tsx', 'utf8');
code = code.replaceAll('Array.from(selectedTests).forEach(tName => {', 'Array.from(selectedTests).forEach((tName: any) => {');
code = code.replaceAll('Object.keys(polyData.groups).forEach(g => {', 'Object.keys(polyData.groups).forEach((g: any) => {');
code = code.replaceAll('if (!next.tests[popover.testName]) next.tests[popover.testName] = { points: 1 };', 'if (!next.tests[popover.testName as any]) next.tests[popover.testName as any] = { points: 1 } as any;');
code = code.replaceAll('delete next.tests[popover.testName].group;', 'delete next.tests[popover.testName as any].group;');
fs.writeFileSync('src/components/ProblemConfigModal.tsx', code);
