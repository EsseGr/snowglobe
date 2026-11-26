FROM python:3.12-slim
WORKDIR /srv
COPY app ./app
RUN useradd --system --no-create-home app && mkdir /data && chown app /data
USER app
ENV PORT=8000 DATA_DIR=/data
EXPOSE 8000
VOLUME /data
CMD ["python3", "app/server.py"]
