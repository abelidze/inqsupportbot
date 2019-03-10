FROM node:11.11.0-alpine

RUN mkdir -p /chat
WORKDIR /chat
COPY . .

EXPOSE 9090

CMD [ "yarn", "start" ]