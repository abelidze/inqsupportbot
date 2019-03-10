FROM node:latest

RUN mkdir -p /chat
WORKDIR /chat
COPY . .
RUN yarn install

EXPOSE 9090

CMD [ "node", "server.js" ]