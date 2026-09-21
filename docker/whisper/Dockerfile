FROM debian:bookworm-slim AS build
ARG WHISPER_CPP_REF=v1.9.4
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_CPP_REF}" https://github.com/ggml-org/whisper.cpp.git /src
WORKDIR /src
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release -j2 --target whisper-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libgomp1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/whisper
COPY --from=build /src/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=build /src/models /opt/whisper/models
EXPOSE 8080
ENTRYPOINT []
CMD ["whisper-server","--host","0.0.0.0","--port","8080","-m","/models/ggml-small.bin"]
