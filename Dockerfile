# Etapa de dependencias
FROM node:18-slim AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
# Usar npm install para evitar fallo por lock desincronizado en CI
RUN npm install --omit=dev --no-audit --no-fund

# Etapa de producción
FROM node:18-slim AS runner
WORKDIR /usr/src/app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-dejavu-core \
    ghostscript \
    qpdf \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

# Railway expone el puerto asignado en la variable PORT (usual: 8080)
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://localhost:'+ (process.env.PORT||8080) +'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD [ "npm", "start" ]
