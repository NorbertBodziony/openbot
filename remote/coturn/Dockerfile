FROM coturn/coturn:4.17.2-r0
COPY remote/coturn/turnserver.conf /etc/coturn/openbot.conf
COPY remote/coturn/entrypoint.sh /usr/local/bin/openbot-coturn
ENTRYPOINT ["/usr/local/bin/openbot-coturn"]
