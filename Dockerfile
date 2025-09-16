# Use Node.js 20 as base image
FROM node:20

# Set working directory inside container
WORKDIR /app

# Copy only package files first (better layer caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port your app runs on (matches PORT=5001 in docker-compose)
EXPOSE 5001

# Start the app
CMD ["node", "server.js"]
