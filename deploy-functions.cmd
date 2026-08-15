@echo off
setlocal enabledelayedexpansion

REM ===================================================================
REM  FenceFlow - deploy the Supabase Edge Functions
REM
REM  Double-click this file, or run it from a terminal. Safe to re-run:
REM  deploying again just replaces the old version of each function.
REM
REM  This is a .cmd on purpose. PowerShell script execution is disabled
REM  on this machine, so a .ps1 would be refused before it ran a line.
REM  Batch files are not subject to that policy. Same reason every npx
REM  call below is "npx.cmd" -- plain "npx" resolves to npx.ps1, which
REM  is what produced "running scripts is disabled on this system".
REM ===================================================================

cd /d "%~dp0"

set PROJECT_REF=newcrgafcptspmapacrx
set FAILED=

echo.
echo  FenceFlow - Edge Function deploy
echo  ================================
echo.

REM ---- Pre-flight: are the files actually here? --------------------
if not exist "supabase\functions" (
    echo  ERROR: no "supabase\functions" folder here.
    echo  Run this from the FenceEstimator project folder.
    echo  Right now you are in: %CD%
    goto :fail
)

for %%F in (create-payment-link create-checkout-session stripe-webhook) do (
    if not exist "supabase\functions\%%F\index.ts" (
        echo  ERROR: missing supabase\functions\%%F\index.ts
        echo  Pull the latest from GitHub and try again.
        goto :fail
    )
)
echo  [ok] All three function files found.

REM ---- Pre-flight: is Node installed? ------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js not found. Install it from https://nodejs.org
    goto :fail
)
echo  [ok] Node.js found.

REM ---- Log in if needed --------------------------------------------
REM  "projects list" is a cheap authenticated call, so it doubles as a
REM  login check. Sending a browser off to log in when there is already
REM  a valid session is just noise.
echo.
echo  Checking Supabase login...
call npx.cmd -y supabase projects list >nul 2>&1
if errorlevel 1 (
    echo  Not logged in. A browser window will open - approve it there.
    echo.
    call npx.cmd -y supabase login
    if errorlevel 1 (
        echo  ERROR: login failed or was cancelled.
        goto :fail
    )
) else (
    echo  [ok] Already logged in.
)

REM ---- Deploy ------------------------------------------------------
REM  Called by the signed-in app and website, so JWT verification stays
REM  on for these two.
echo.
echo  ---------------------------------------------------------------
echo   1/3  create-payment-link      (job deposits and invoices)
echo  ---------------------------------------------------------------
call npx.cmd -y supabase functions deploy create-payment-link --project-ref %PROJECT_REF%
if errorlevel 1 set FAILED=!FAILED! create-payment-link

echo.
echo  ---------------------------------------------------------------
echo   2/3  create-checkout-session  (FenceFlow subscription)
echo  ---------------------------------------------------------------
call npx.cmd -y supabase functions deploy create-checkout-session --project-ref %PROJECT_REF%
if errorlevel 1 set FAILED=!FAILED! create-checkout-session

REM  Stripe's servers call this one. They have no FenceFlow login, so
REM  leaving JWT verification on would reject every message Stripe sends
REM  and nothing would ever be marked paid. The function authenticates
REM  the caller itself by verifying Stripe's signature over the raw body.
echo.
echo  ---------------------------------------------------------------
echo   3/3  stripe-webhook           (Stripe calls this - no JWT)
echo  ---------------------------------------------------------------
call npx.cmd -y supabase functions deploy stripe-webhook --project-ref %PROJECT_REF% --no-verify-jwt
if errorlevel 1 set FAILED=!FAILED! stripe-webhook

REM ---- Report ------------------------------------------------------
echo.
echo  ===============================================================
if "!FAILED!"=="" (
    echo   All three deployed.
    echo.
    echo   Still to do in the Supabase dashboard, under
    echo   Edge Functions -^> Secrets:
    echo.
    echo     STRIPE_SECRET_KEY       your sk_test_... from Stripe
    echo     SITE_URL                https://marchenry73.github.io/FenceFlow
    echo     STRIPE_WEBHOOK_SECRET   the whsec_... Stripe gives you
    echo                             when you add the webhook endpoint
    echo.
    echo   Then point Stripe at:
    echo   https://%PROJECT_REF%.supabase.co/functions/v1/stripe-webhook
) else (
    echo   FAILED:!FAILED!
    echo.
    echo   Scroll up for the actual error. Most common causes:
    echo     - not logged in       run: npx.cmd -y supabase login
    echo     - wrong project       check the ref above matches Supabase
    echo     - no internet
)
echo  ===============================================================
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
