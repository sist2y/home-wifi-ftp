# 家用檔案分享

同一 Wi-Fi 傳檔。呢部機跑 server，第二部機用瀏覽器開網址。唔使 FTP，唔使裝 client。

```
node server.js
node server.js D:\想share嘅資料夾
```

預設 share `shared/`。開咗會彈本機瀏覽器，畫面有 Wi-Fi 名同網址（`http://IP:8787`）。
網址會優先使用 Wi-Fi 網卡 IPv4，避免選到 WSL 等虛擬網卡。

## 防火牆（Windows，要管理員）

唔一定要跑 netsh。好多機無 rule 都入到。連唔到先至加。

放行：

```
netsh advfirewall firewall add rule name="home-wifi-ftp" dir=in action=allow protocol=TCP localport=8787
```

刪走：

```
netsh advfirewall firewall delete rule name="home-wifi-ftp"
```

本機開到唔代表其他人開到。Wi-Fi 網絡類別要設做 Private；Public 會擋 inbound。唔好關成個防火牆。

## 用法

- 第二部機要同一 Wi-Fi，貼上網址。唔好用流動數據、唔好連 guest。
- 有啲 router 開咗 AP isolation，同一 Wi-Fi 都互唔見。
- Wi-Fi 名只係確認大家同一網絡。真正用來連嘅係 IP 網址。
- 「上載」：把而家呢部機嘅檔案丟入 host 個資料夾。Host 自己用 Explorer 拖入 `shared/` 都得。
- 撳檔名即下載。瀏覽器會存去 Downloads，唔可以指定本機資料夾。大檔案會直接串流；下載資料夾會即時建立並串流 ZIP，唔會先將成個檔案或 ZIP 載入記憶體。ZIP 支援超過 4 GB 嘅檔案。
- 下載資料夾時頁面會提示 ZIP 正在準備；傳送進度同完成狀態請睇瀏覽器下載列。下載單一大檔案時，`/dl` 支援 HTTP byte ranges，方便支援續傳嘅下載工具。
- 對方開條網址見到嘅就係同一個畫面，唔使 `client.js`。

## 限制

- 而家冇密碼。同一個 LAN 識條網址就讀寫到。要限制用一條 PIN 就夠；白名單 IP／MAC 喺家用好煩（DHCP 換 IP，iPhone 隨機 MAC）。
- HTTP 明文。屋企 Wi-Fi 已加密（例如 WPA3）就用得過，唔好當銀行級。
- 未做刪檔、開資料夾、自動改防火牆。

## 無瀏覽器時（curl）

```
curl -O "http://IP:8787/dl?path=檔名"
curl -T 檔名 "http://IP:8787/up?path=&name=檔名"
```
