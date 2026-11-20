# syntax=docker/dockerfile:1.7
# Self-hosted gateway: scripts/local-proxy.mjs, the same routing and /internal block as vercel.json.
# No dependencies at runtime (node: built-ins only).
FROM node:24-alpine
ENV NODE_ENV=production PORT=3080
WORKDIR /app
COPY --chown=node:node scripts/local-proxy.mjs ./scripts/local-proxy.mjs
USER node
EXPOSE 3080
HEALTHCHECK --interval=15s --timeout=3s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/local-proxy.mjs"]
