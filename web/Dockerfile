FROM node:22-bullseye AS dev
WORKDIR /workspace
RUN corepack enable && corepack prepare yarn@4.5.1 --activate
RUN apt-get update -y && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV APP_ENV=dev
EXPOSE 3000
CMD ["/entrypoint.sh"]

FROM node:22-bullseye AS build
WORKDIR /app
RUN corepack enable && corepack prepare yarn@4.5.1 --activate
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
RUN yarn install --immutable
COPY . ./
RUN yarn build
RUN mkdir -p /opt/app \
 && cp -r .next package.json yarn.lock .yarn .yarnrc.yml node_modules /opt/app \
 && if [ -d public ]; then cp -r public /opt/app; fi

FROM node:22-bullseye AS prod
WORKDIR /opt/app
RUN corepack enable && corepack prepare yarn@4.5.1 --activate
RUN apt-get update -y && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/app /opt/app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NODE_ENV=production
ENV APP_ENV=prod
EXPOSE 3000
CMD ["/entrypoint.sh"]
