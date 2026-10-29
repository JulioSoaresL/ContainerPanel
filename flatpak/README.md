# Flatpak

App ID: `io.github.JulioSoaresL.ContainerPanel`. O app é o Electron de `electron/main.js`, que sobe o
`server.js` numa porta livre em 127.0.0.1. As ações de projeto usam o binário standalone do
Docker Compose embutido no pacote (`PANEL_COMPOSE_BIN=/app/bin/docker-compose`).

## Build local

```bash
flatpak install --user flathub org.flatpak.Builder
flatpak run org.flatpak.Builder --user --install --install-deps-from=flathub --force-clean \
  build-dir flatpak/io.github.JulioSoaresL.ContainerPanel.yml
flatpak run io.github.JulioSoaresL.ContainerPanel
```

Os dados ficam em `~/.var/app/io.github.JulioSoaresL.ContainerPanel/data/docker-panel/`.

Se o build falhar com `Failure spawning rofiles-fuse`, adicione `--disable-rofiles-fuse`.

## Gerar o arquivo para a release

```bash
flatpak run org.flatpak.Builder --user --force-clean --install-deps-from=flathub \
  --repo=repo build-dir flatpak/io.github.JulioSoaresL.ContainerPanel.yml
flatpak build-bundle repo ContainerPanel-x86_64.flatpak io.github.JulioSoaresL.ContainerPanel \
  --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo
```

Anexe o `ContainerPanel-x86_64.flatpak` à release no GitHub, sempre com esse nome, porque o link do
README aponta para `releases/latest/download/ContainerPanel-x86_64.flatpak`.

## Atualizar dependências

O build do Flatpak é offline, então toda mudança no `package-lock.json` exige regenerar as fontes:

```bash
pipx install "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node"
flatpak-node-generator npm package-lock.json -o flatpak/generated-sources.json
```

Ao atualizar o Docker Compose, troque a versão nas URLs e os `sha256` pelos arquivos
`docker-compose-linux-<arch>.sha256` publicados no release.

## Lint

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest flatpak/io.github.JulioSoaresL.ContainerPanel.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo   # após build com --repo=repo
appstreamcli validate flatpak/io.github.JulioSoaresL.ContainerPanel.metainfo.xml
```

## Permissões

- `--filesystem=/run/docker.sock` / `xdg-run/docker.sock`: o app é um cliente da API do Docker.
- `--filesystem=home`: localiza arquivos compose e o compose precisa ler os projetos nos caminhos originais.
- Sem `--share=network`: o servidor do painel e a janela ficam no loopback do próprio sandbox, e os
  links para as portas dos containers abrem no navegador do sistema.

## Notas do build

- O build é offline. O Electron não baixa o binário no `npm ci`, então o manifest extrai o zip
  que vem no `generated-sources.json` (na versão do `package.json`) para `node_modules/electron/dist`.
- `npmRebuild: false` no `package.json`: o electron-builder tentaria recompilar o `cpu-features`
  (dependência opcional do `ssh2`, via dockerode) baixando headers. O painel não usa SSH.

## Limitações

- O usuário precisa ter acesso ao socket do Docker (grupo `docker` ou Docker rootless).
- Não há CLI `docker` nem plugin `buildx` no sandbox. Subir projetos com imagens prontas funciona;
  serviços com `build:` dependem do builder que o Compose consegue usar sem o buildx (ainda não testado).
