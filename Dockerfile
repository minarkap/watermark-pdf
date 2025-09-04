# Etapa de dependencias
FROM node:18-slim AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Etapa de producción
FROM node:18-slim AS runner
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

# Railway usa la variable PORT para exponer el servicio
EXPOSE 3000
CMD [ "npm", "start" ]
