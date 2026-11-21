# SalaON

Sistema SalaON para gestão de agenda, clientes, equipe e financeiro de pequenos salões. Funciona localmente com SQLite e pode ser publicado no Render conectado ao PostgreSQL do Supabase.

## Requisitos

- Node.js 22.5 ou mais recente (recomendado Node.js 24)
- npm, incluído com Node.js
- npm para instalar o cliente PostgreSQL pg

Sem DATABASE_URL, o app usa SQLite local em `data/salaon.sqlite`. Com DATABASE_URL, usa PostgreSQL no Supabase.

## Início rápido no Windows PowerShell

1. Extraia o projeto para uma pasta local.
2. Instale as dependências com `npm ci`.
3. Copie `.env.example` para `.env` se quiser configurar banco, senha inicial ou integração de IA.
4. Crie uma senha própria com pelo menos 12 caracteres e execute:

```powershell
npm run seed -- --password "EscolhaUmaSenhaCom12Caracteres"
npm start
```

5. Acesse [http://localhost:3000](http://localhost:3000) e entre com:
   - E-mail: `dona@salaon.local`
   - Senha: a senha que você informou ao comando de seed

No primeiro acesso, o sistema exige que a senha inicial seja trocada. A senha do seed não está embutida no código e o seed não a imprime. Se preferir, defina `SALAON_DEMO_PASSWORD` e `SALAON_DEMO_EMAIL` no ambiente antes de executar `npm run seed`.

O seed só cria dados quando o banco ainda está vazio. Para uma nova base de demonstração, pare o servidor, mova ou remova o arquivo `data/salaon.sqlite` e rode o seed novamente. Guarde uma cópia do banco caso queira preservar os dados.

## O que está implementado

- **Identidade visual:** superfícies de porcelana com transparência seletiva, navegação em ameixa profunda, detalhes de ametista e acentos champanhe. Os logotipos enviados aparecem no cabeçalho, no acesso, no mobile e no ícone da aba, nos arquivos public/assets/salaon-symbol.jpg e public/assets/salaon-wordmark.jpg. DM Sans e Fraunces usam fallbacks locais quando as fontes externas não carregam.
- **Painéis por perfil:** a dona vê o resumo financeiro do salão, alertas e agenda. A recepção acompanha os horários e pode confirmar, concluir, cadastrar clientes e registrar recebimentos manuais. Cada profissional vê somente os próprios atendimentos, serviços habilitados e comissões individuais. Os dados são limitados pelo servidor.
- **Financeiro e caixa:** receitas, despesas, categorias, método, observações, vencimento, status pendente ou pago, recorrência, pesquisa e filtro. Baixar uma conta registra a data e a forma informada. Estornar um lançamento pago cria um lançamento compensatório e mantém o original e a auditoria.
- **Recorrência:** ao cadastrar um lançamento com vencimento e regra semanal, mensal, trimestral ou anual, o sistema cria a ocorrência inicial e as onze próximas como pendentes. Cada ocorrência pode ser editada ou estornada individualmente.
- **Agenda:** dia ou semana, cliente, profissional, serviços, duração, remarcação, confirmação, conclusão, cancelamento e bloqueios. O servidor recusa conflito de horário. Concluir um atendimento gera o demonstrativo de comissão uma vez; o recebimento é registrado em separado.
- **Clientes:** cadastro, pesquisa, histórico, atualização, consentimento de contato e desativação preservando atendimentos.
- **Equipe e catálogo:** profissionais, habilitação individual de serviços, comissão padrão, preços, duração e comissão. Atendimentos salvam cópias dos dados do serviço, preservando o histórico após uma alteração do catálogo.
- **Comissões:** demonstrativo calculado ao concluir atendimento. Registrar o pagamento cria uma despesa financeira vinculada.
- **Relatórios:** totais pagos por período, categorias, serviços concluídos, comissões e inadimplência. Exportação CSV usa o mesmo filtro de datas.
- **Acessos:** sessão protegida por cookie HttpOnly e SameSite, hash de senha PBKDF2, token CSRF, limite simples de tentativas de login, troca obrigatória de senha inicial e autorização no servidor.
- **Auditoria:** operações administrativas e financeiras relevantes guardam pessoa, ação, registro e detalhes sem armazenar senha.
- **Copiloto Financeiro SalaON:** modo local determinístico, baseado em agregados consultados do salão, com evidências e limites. Se todas as variáveis do provedor estiverem configuradas, o servidor também pode enviar a pergunta e somente dados financeiros agregados a uma API compatível com Chat Completions.
- **Interface:** navegação agrupada, avisos derivados dos registros atuais, painel com indicadores operacionais, agenda diária/semanal/mensal, gráficos acessíveis, perfis separados e superfícies Liquid Glass seletivas. Login tem alternância de visibilidade da senha; a dona pode redefinir o acesso da equipe com senha temporária e troca obrigatória. Temas claro, escuro e dispositivo acompanham a preferência do sistema na primeira visita e guardam a escolha em localStorage. Layout responsivo, estados vazios/erro e suporte a `prefers-reduced-motion`.

## Papéis

| Papel | Acesso |
| --- | --- |
| Dona do salão | Painel e financeiro do salão, relatórios, copiloto, agenda, clientes, equipe, serviços, configurações e criação de acessos |
| Recepção | Painel da recepção, agenda, cadastro de clientes, consulta de serviços e equipe; pode confirmar e concluir atendimentos e registrar recebimentos manuais |
| Profissional | Painel individual, agenda atribuída ao próprio perfil, serviços habilitados e demonstrativos das próprias comissões |

A dona cria um acesso por pessoa em **Configurações → Acessos e papéis**. Cada funcionária entra com seu próprio e-mail e senha; o perfil e as permissões vêm da conta e são validados no servidor. Ao criar um acesso de profissional, vincule-o ao cadastro correspondente da equipe.

Os dados pessoais e financeiros são restringidos no servidor. Ocultar uma área na navegação não é a única barreira de autorização.

## Modelo de dados e persistência

As migrações versionadas criam salão, usuários e sessões, profissionais e serviços habilitados, clientes, catálogo, categorias, formas de pagamento, atendimentos e itens com cópias históricas, lançamentos em centavos, comissões, sessões de caixa e auditoria. `migrations/` contém o esquema SQLite; `migrations/postgres/` contém o esquema PostgreSQL.

O servidor inclui `salon_id` em consultas e gravações e verifica o salão de referências relacionadas. Os valores financeiros são inteiros em centavos; não dependem de ponto flutuante. O servidor aplica migrações pendentes ao iniciar.

## Configuração opcional do copiloto com provedor

Copie `.env.example` para `.env` e configure no processo do servidor:

- `AI_BASE_URL`: endereço base compatível com Chat Completions (exemplo para uma instalação OpenAI-compatible pode terminar em `/v1`)
- `AI_API_KEY`: chave do provedor
- `AI_MODEL`: identificador do modelo aceito pelo provedor

Sem as três configurações, a SalaON AI usa apenas análise local e identifica a origem. Com provedor configurado, o servidor envia uma pergunta sanitizada e indicadores financeiros e operacionais agregados; consultas com dados de retorno de clientes ficam no modo local. Não envia nomes, telefones, e-mails nem a lista de clientes. A chave não aparece no JavaScript do navegador. Se o provedor estiver indisponível, a interface informa que voltou à análise local.

A análise local dá respostas determinísticas e não simula uma chamada de modelo. Projeções lineares são apresentadas como estimativas com limites explícitos e o copiloto não efetua lançamentos.

## Pagamentos, notificações e privacidade

Esta demonstração **não processa Pix nem cartões**, não cria cobranças reais, não verifica autorização bancária e não envia WhatsApp ou e-mail. O registro de forma de pagamento é manual. Um lançamento só vira pago quando uma pessoa com permissão o confirma na interface. Um QR code ou forma de pagamento não é tratado como confirmação de recebimento.

Não armazene número completo de cartão, CVV ou senha em observações. O app não tem provedor de pagamentos, webhooks ou serviço de notificações configurado. Para uso real, será necessário contratar e configurar essas integrações.

O cadastro de clientes é limitado a nome, contato, notas operacionais e consentimento de contato. O sistema permite corrigir e desativar cadastros. A política de retenção e pedidos de exclusão devem ser definidos pelo salão antes do uso com dados reais; a demonstração não substitui uma avaliação jurídica ou uma política LGPD institucional.

## Publicar no Render com Supabase

O projeto inclui o manifesto render.yaml. Para publicar:

1. Crie um projeto Supabase e copie a URL de conexão PostgreSQL no modo Session pooler. A URL é um segredo; não a coloque no Git.
2. Envie este projeto para um repositório Git privado e conecte o repositório ao Render. Escolha New → Blueprint para usar render.yaml, ou crie um Web Service com build npm ci e start npm start.
3. No serviço Render, defina DATABASE_URL com a URL do Supabase. Se o banco estiver vazio, defina SALAON_DEMO_PASSWORD com uma senha inicial forte antes de rodar o seed; mantenha o valor no painel do Render.
4. O servidor cria o esquema PostgreSQL e aplica as migrações na inicialização. Para um banco novo, execute npm run seed uma vez pelo Shell do Render. O seed só cria dados quando não há salão cadastrado.
5. Abra o endereço onrender.com do serviço. O Render verifica /api/health.

Para levar os dados do SQLite que já existem neste computador, pare o servidor local, configure DATABASE_URL no arquivo local .env e execute npm run migrate:sqlite-to-postgres antes do seed. O importador usa SALAON_DB_PATH ou data/salaon.sqlite, importa as tabelas em uma transação e cancela sem alterar o destino se já houver um salão no Supabase. Guarde uma cópia do SQLite até confirmar a migração.

## Limites desta versão

- Em hospedagem, use Supabase PostgreSQL por `DATABASE_URL`; SQLite fica para desenvolvimento local. Faça backups periódicos no Supabase.
- A abertura e o fechamento do caixa acompanham valores informados e lançamentos feitos pelo app; não há integração com gaveta, maquininha, banco ou extrato.
- Regras de comissão são percentual por serviço e ficam fotografadas nos itens do atendimento. Custos de materiais não são modelados; receita por serviço não equivale a lucro.
- A recuperação de senha não envia e-mail: a dona redefine acessos da equipe com senha temporária; recuperar a própria conta da dona exige administração local do servidor. Notificações são calculadas quando consultadas, sem push ou entrega externa. Não há portal da cliente nem lembretes automáticos.
- A senha inicial deve ser trocada por cada pessoa convidada. A gestora deve usar senhas distintas e manter o banco e o arquivo `.env` protegidos no computador.

## Estrutura

```text
migrations/   esquema SQL versionado (inclui habilitações individuais da equipe)
public/       interface responsiva HTML, CSS e JavaScript; logos em public/assets/
scripts/      seed e importação SQLite para PostgreSQL
src/          servidor HTTP, sessão, regras de domínio e adaptador SQLite/PostgreSQL
data/         banco SQLite local (criado ao rodar)
```
