FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend ./frontend
ARG VITE_API_BASE_URL=http://localhost:3001/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build:web

FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY frontend ./frontend
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 4173
CMD ["npm", "run", "preview"]
