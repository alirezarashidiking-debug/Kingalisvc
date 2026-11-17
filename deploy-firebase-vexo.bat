@echo off
echo VEXO Firebase deployment helper
echo This requires Node.js 20+ and Firebase CLI on this computer.
echo Confirm you are in the VEXO project folder and project vexo-v2 is selected.
pause
cd functions
call npm install
if errorlevel 1 goto fail
cd ..
call firebase use vexo-v2
if errorlevel 1 goto fail
call firebase deploy --only database,functions
if errorlevel 1 goto fail
echo Deployment command completed. Check Firebase Console logs before enabling payments.
pause
exit /b 0
:fail
echo Deployment failed. Read the error above; do not enable Mainnet payments.
pause
exit /b 1
