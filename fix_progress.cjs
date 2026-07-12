const fs = require('fs');
let code = fs.readFileSync('src/components/ProgressWindow.tsx', 'utf8');
code = code.replace("return (\n    <>) => clearInterval(timer);", "return () => clearInterval(timer);");
fs.writeFileSync('src/components/ProgressWindow.tsx', code);
