# --- Stage 1: Build the Next.js app ---
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the frontend code
COPY . .

# The API URL will be passed in from Render during the build process
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Build the Next.js application
RUN npm run build

# --- Stage 2: Serve the app ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV production

# Copy the build output and necessary files from the builder stage
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Expose port 3000
EXPOSE 3000

# Start the Next.js server
CMD ["npm", "start"]