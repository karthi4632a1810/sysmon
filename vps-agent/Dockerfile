FROM node:20-alpine

# Install docker-cli so the agent can talk directly to the host's Docker socket
RUN apk add --no-cache docker-cli procps curl

WORKDIR /app

COPY package.json ./
COPY index.js ./

ENV PORT=55555
ENV HOST=0.0.0.0

EXPOSE 55555

CMD ["node", "index.js"]
