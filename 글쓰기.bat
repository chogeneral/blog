@echo off
title 네이버 블로그 글쓰기 자동화
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js 가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주시기 바랍니다.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo 처음 실행입니다. 필요한 프로그램을 설치합니다. 2분에서 5분 정도 걸립니다.
  call npm install
  if errorlevel 1 (
    echo [오류] 설치에 실패했습니다. 인터넷 연결을 확인해 주시기 바랍니다.
    pause
    exit /b 1
  )
)

echo.
echo ===========================================================
echo    네이버 블로그 글쓰기 자동화 (한 번에 최대 20개 글)
echo ===========================================================
echo  - 글마다 키워드를 쉼표로 최대 3개 넣습니다. 첫 번째가 메인 키워드입니다.
echo    예) 저혈압수치, 저혈압 증상, 저혈압 관리
echo  - 제목을 넣으면 그 제목 그대로 쓰고, 글도 그 제목에 맞춰 씁니다.
echo    제목을 비워 두면 키워드를 조합해 프로그램이 자동으로 만듭니다.
echo  - 키워드를 비우고 Enter 를 누르면 입력을 마칩니다.
echo.

rem 제목에 기호(앰퍼샌드, 퍼센트, 느낌표, 괄호 등)가 있어도 그대로 넘기도록 지연 확장으로 모읍니다.
rem 큰따옴표는 실행 줄을 깨뜨리므로 작은따옴표로 바꿉니다.
setlocal EnableDelayedExpansion
set "ARGS="
set "COUNT=0"

:ask
set /a NEXT=COUNT+1
if !NEXT! GTR 20 goto done
set "KW="
set "TT="
set /p "KW=글 !NEXT! 키워드 (비우면 끝) : "
if not defined KW goto done
set /p "TT=글 !NEXT! 제목   (비우면 자동) : "
set "KW=!KW:"='!"
if defined TT set "TT=!TT:"='!"
set "ARGS=!ARGS! --kw!NEXT!="!KW!" --title!NEXT!="!TT!""
set "COUNT=!NEXT!"
echo.
goto ask

:done
if "!COUNT!"=="0" (
  echo.
  echo 글 1 키워드는 꼭 입력해야 합니다.
  pause
  exit /b 1
)

echo.
echo  입력한 글 !COUNT!개를 차례로 작성합니다.
echo.

choice /c yn /n /m " 바로 글을 쓰고 임시저장까지 진행할까요? [Y=바로시작 / N=화면에서확인] "
if errorlevel 2 (set "AUTORUN=") else (set "AUTORUN=--auto")

echo.
echo  프로그램을 시작합니다.
echo  네이버 로그인 창이 뜨면 한 번만 로그인해 주시기 바랍니다.
echo  (로그인 정보는 data\naver-profile 폴더에 남아 다음부터는 자동으로 들어갑니다)
echo.

rem cmd 를 한 번 더 거쳐 실행해, 제목 안의 기호가 이 bat 에서 다시 해석되지 않게 합니다.
cmd /s /c ""node_modules\.bin\electron.cmd" . !ARGS! !AUTORUN!"
set "EXITCODE=!ERRORLEVEL!"

echo.
rem 프로그램이 이미 켜져 있으면 새로 띄우지 않고, 방금 넣은 키워드를 켜져 있는 창으로 넘깁니다(종료 번호 3).
if "!EXITCODE!"=="3" (
  echo 프로그램이 이미 켜져 있어 새로 띄우지 않았습니다.
  echo 방금 입력한 키워드와 제목은 켜져 있는 프로그램 창의 글 목록으로 넘겼습니다.
  echo 그 창의 진행 기록에서 확인해 주시기 바랍니다.
) else (
  echo 프로그램이 종료되었습니다.
)
pause
