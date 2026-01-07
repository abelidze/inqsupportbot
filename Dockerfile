FROM node:24.12.0

RUN mkdir -p /chat
WORKDIR /chat
COPY . .

EXPOSE 9090

CMD [ "yarn", "start" ]
