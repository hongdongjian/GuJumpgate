FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app.py /app/app.py

EXPOSE 8080

# To route outbound traffic through a multi-node proxy pool, deploy xray as a
# sidecar (see services/checkout-converter/deploy/compose/) and set
# OPENAI_PROXY_URL=http://xray:7891 in the application container's environment.
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", "-b", "0.0.0.0:8080", "app:app"]
