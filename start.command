#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Нужен Node.js версии 20 или новее: https://nodejs.org/"
  read -k 1 "?Нажмите клавишу, чтобы закрыть окно..."
  exit 1
fi
npm start
