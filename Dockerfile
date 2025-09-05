# Etapa de dependencias
FROM node:18-slim AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Etapa de producción
FROM node:18-slim AS runner
WORKDIR /usr/src/app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-dejavu-core \
    ghostscript \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

# Railway expone el puerto asignado en la variable PORT (usual: 8080)
EXPOSE 8080
CMD [ "npm", "start" ]
