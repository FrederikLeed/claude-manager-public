FROM ghcr.io/berriai/litellm:main-latest
COPY config.yaml /app/config.yaml
COPY copilot-entrypoint.sh /app/copilot-entrypoint.sh
RUN sed -i 's/\r$//' /app/copilot-entrypoint.sh && chmod +x /app/copilot-entrypoint.sh
ENTRYPOINT ["/app/copilot-entrypoint.sh"]
