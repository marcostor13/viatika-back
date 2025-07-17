FROM node:20-slim AS build
WORKDIR /app
COPY package*.json .
RUN npm install --force
COPY . .
EXPOSE 3016
CMD [ "npm", "start" ]