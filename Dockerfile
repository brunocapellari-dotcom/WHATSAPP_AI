FROM python:3.12-alpine
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml README.md ./
COPY app ./app
COPY migrations ./migrations
COPY scripts ./scripts
RUN pip install --no-cache-dir .
USER 65532:65532
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
