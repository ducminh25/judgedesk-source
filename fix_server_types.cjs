const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  'status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "FAIL" | "PENDING" | "PARTIAL";',
  'status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "FAIL" | "MLE" | "PENDING" | "PARTIAL";'
);
fs.writeFileSync('server.ts', code);
