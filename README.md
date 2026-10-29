# docker-panel

Painel web local para gerenciar **todos** os containers Docker da máquina — de qualquer
`docker compose`, de qualquer pasta, ou containers avulsos (`docker run`).

- Lista tudo o que o Docker conhece, agrupado por projeto compose (+ "Avulsos")
- **Subir / Parar / Derrubar / Reiniciar** um projeto inteiro
- **Iniciar / Parar / Reiniciar** um container
- **Terminal** (bash, ou sh se não houver bash) em qualquer container rodando, em abas
- Portas publicadas viram links `localhost:PORTA`
- Projetos montados em cada container rodando, com o link pelo nginx (ou a porta do
  container) e um **Terminal** que já abre na pasta do projeto

## Instalação

Baixe o [**ContainerPanel-x86_64.flatpak**](https://github.com/JulioSoaresL/ContainerPanel/releases/latest/download/ContainerPanel-x86_64.flatpak)
da última release e instale:

```bash
flatpak install --user ContainerPanel-x86_64.flatpak
flatpak run io.github.JulioSoaresL.ContainerPanel
```

O runtime necessário é baixado do Flathub na instalação. É preciso ter o Docker instalado e o
usuário com acesso ao socket (grupo `docker` ou Docker rootless). Para atualizar, baixe o arquivo
da release nova e rode o `flatpak install` de novo.

## Uso

```bash
./start.sh            # instala dependências na 1ª vez, sobe e abre o navegador
PANEL_PORT=8000 ./start.sh
```

Acesse <http://127.0.0.1:7777>.

## App desktop (Electron / Flatpak)

O mesmo painel também roda como app, sem precisar subir o servidor na mão: o app inicia o
`server.js` numa porta livre e abre numa janela própria.

```bash
npm install
npm run app           # roda o app em modo dev (no Ubuntu 24.04+: npm run app -- --no-sandbox)
npm run build:dir     # gera o app em dist/linux-unpacked/
```

No app, os projetos ficam salvos em `~/.local/share/docker-panel/`, e não em `data/`.
Para o pacote Flatpak e a publicação no Flathub, veja [flatpak/README.md](flatpak/README.md).

## Requisitos

- Node.js 18+
- Seu usuário com acesso ao Docker (`/var/run/docker.sock`)

## Como funciona

- Containers e terminal: API do Docker via socket (`dockerode`).
- Ações de projeto: `docker compose -p <projeto> -f <arquivos> --project-directory <dir>`,
  usando os caminhos que o próprio Docker grava nos labels dos containers.
- Projetos vistos ficam salvos em `data/projects.json`, então continuam na lista
  depois de um "Derrubar" (e podem ser subidos de novo). O botão ✕ remove da lista.

## Segurança

O painel dá shell em qualquer container, por isso escuta **apenas em 127.0.0.1** e
recusa requisições cujo `Host`/`Origin` não seja o próprio painel.
