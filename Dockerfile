FROM node:18-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy all code/templates into the image
COPY . .

# ONLY create the internal config 
# server.js creats 'logs' folder
RUN mkdir -p /app/config

CMD ["node", "server.js"]