#!/bin/bash
trap "exit" INT

echo "###########################################"
echo "##             InqSupportBot             ##"
echo "###########################################"

while true
do
node server.js
echo "[CRASH!]"
echo "Rebooting in:"
for i in {3..1}
do
echo "$i..."
sleep 1
done
echo "##########################################"
echo "#    InqSupportBot is restarting now     #"
echo "##########################################"
done