FROM debian:bookworm-slim AS build
ARG WHISPER_CPP_COMMIT=927cfce34f31707e17f2bff35c349632fb9e2c3a
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make \
    && rm -rf /var/lib/apt/lists/*
RUN git init /src \
    && git -C /src remote add origin https://github.com/ggml-org/whisper.cpp.git \
    && git -C /src fetch --depth 1 origin "${WHISPER_CPP_COMMIT}" \
    && git -C /src checkout --detach FETCH_HEAD \
    && test "$(git -C /src rev-parse HEAD)" = "${WHISPER_CPP_COMMIT}"
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
