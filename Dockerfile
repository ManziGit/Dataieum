# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend-src/package.json frontend-src/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend-src/ ./
RUN npm run build

FROM node:22-bookworm-slim AS codex
ARG CODEX_VERSION=0.154.0-alpha.6.2
RUN npm install --global --ignore-scripts @openai/codex@${CODEX_VERSION} \
 && mkdir /codex \
 && cp /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex /codex/codex

FROM python:3.13-slim AS atlas
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app:/app/operations
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
 && useradd --uid 10001 --create-home atlas \
 && mkdir /data && chown atlas:atlas /data
COPY discovery_harness/ /app/discovery_harness/
COPY catalog.py confidence_graph.py classification_batch.py /app/
COPY registry.py collectors.py collection_audit.py embedding_batch.py /app/
COPY operations/*.py operations/*.sql operations/refresh-sources.json /app/operations/
COPY --from=frontend /build/dist/ /app/frontend/
USER 10001:10001
EXPOSE 8000
CMD ["python","-m","discovery_harness.serve_dataieum"]

FROM atlas AS vector
USER root
RUN pip install --no-cache-dir numpy==2.2.6 faiss-cpu==1.12.0
ENV OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
USER 10001:10001
CMD ["python","-m","discovery_harness.vector_server"]

FROM atlas AS refresh
USER root
ENV TIKTOKEN_CACHE_DIR=/opt/refresh-tiktoken
RUN python -c "import tiktoken; tiktoken.encoding_for_model('text-embedding-3-small')" && chmod -R a+rX /opt/refresh-tiktoken
USER 10001:10001
ENTRYPOINT ["python","/app/operations/refresh.py"]

FROM atlas AS luna
ENV HOME=/luna-home CODEX_HOME=/luna-auth
USER root
RUN pip install --no-cache-dir langgraph==1.2.11 \
 && mkdir -p /luna-home /opt/dataieum-luna && chown atlas:atlas /luna-home && ln -s /app/discovery_harness /opt/dataieum-luna/discovery_harness
COPY experiments/ /app/experiments/
RUN ln -s /app/experiments /opt/dataieum-luna/experiments
COPY --from=codex /codex/codex /usr/local/bin/codex
USER 10001:10001
ENTRYPOINT ["python","-m","experiments.luna_discovery"]
CMD []
