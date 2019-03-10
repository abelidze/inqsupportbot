FROM node:latest

WORKDIR /chat
COPY . .
RUN yarn install

EXPOSE 9090
