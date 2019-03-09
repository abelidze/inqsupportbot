#!/bin/bash
trap "exit" INT

echo "###########################################"
echo "##             InqSupportBot             ##"
echo "###########################################"

while true
do
node server.js
echo "InqSupportBot is crashed!"
echo "Rebooting in:"
for i in {3..1}
do
echo "$i..."
done
echo "##########################################"
echo "#    InqSupportBot is restarting now     #"
echo "##########################################"
done