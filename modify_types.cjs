const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  'status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "FAIL";',
  'status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "FAIL" | "MLE";\n  peakMemory?: number;'
);
fs.writeFileSync('server.ts', code);
