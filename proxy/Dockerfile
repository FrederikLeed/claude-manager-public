FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    squid \
    inotify-tools \
    && rm -rf /var/lib/apt/lists/*

# Copy base config
COPY squid.conf /etc/squid/squid.conf

# Create ACL directory for per-container rules and fix permissions
RUN mkdir -p /etc/squid/acl /var/log/squid /var/spool/squid \
    && touch /etc/squid/acl/default.acl \
    && chown -R proxy:proxy /etc/squid/acl /var/log/squid /var/spool/squid /run

# Copy the ACL watcher script
COPY watch-acls.sh /usr/local/bin/watch-acls.sh
RUN chmod +x /usr/local/bin/watch-acls.sh

EXPOSE 3128

CMD ["/usr/local/bin/watch-acls.sh"]
