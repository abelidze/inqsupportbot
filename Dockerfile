FROM node:latest

RUN mkdir -p /chat
WORKDIR /chat
COPY . .

EXPOSE 9090

CMD [ "yarn", "start" ]