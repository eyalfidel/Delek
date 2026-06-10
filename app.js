const SUPABASE_URL = 'https://oaapgalsprualadbfltv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hYXBnYWxzcHJ1YWxhZGJmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTQ0ODAsImV4cCI6MjA5NjMzMDQ4MH0.JP50HnTaKMg8gv38_tu81gcbTvGEhb6qY1pVzDq5XtE';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentCar = null;
let currentCarMembers = [];
let calculatedOdometer = 0;
let userBalancesGlobal = {}; // שמירת המצב הכספי לצרכי איפוס חובות מהיר

async function login() { await supabaseClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }); }
async function logout() { await supabaseClient.auth.signOut(); window.location.reload(); }

function showScreen(screenId) {
    ['login-screen', 'pending-screen', 'cars-screen', 'app-screen'].forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
}

function switchView(viewName, navElement) {
    document.querySelectorAll('.app-view').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('view-' + viewName).classList.remove('hidden');
    if(navElement) navElement.classList.add('active');
    
    if(viewName === 'dashboard') loadDashboardData();
    if(viewName === 'trip') prepareTripForm();
    if(viewName === 'refuel') prepareRefuelForm();
}

async function initializeApp(user) {
    currentUser = user;
    let userStatus = 'pending';
    
    try {
        // מניעת נעילה עצמית: אם המשתמש הוא אתה, אנו מוודאים שהוא מעודכן כאדמין בדאטהבייס
        if (user.email === 'eyal.fidel@gmail.com' || user.email === 'eyal.fidel@mail.huji.ac.il') {
            await supabaseClient.from('profiles').upsert({ id: user.id, display_name: user.user_metadata.full_name, email: user.email, status: 'admin' });
            userStatus = 'admin';
        } else {
            const { data: existingProfile } = await supabaseClient.from('profiles').select('*').eq('id', user.id).maybeSingle();
            if (!existingProfile) {
                await supabaseClient.from('profiles').insert({ id: user.id, display_name: user.user_metadata.full_name, email: user.email, status: 'pending' });
                userStatus = 'pending';
            } else {
                userStatus = existingProfile.status || 'pending';
                document.getElementById('user-display-name').innerText = existingProfile.display_name || user.user_metadata.full_name;
            }
        }
        
        document.getElementById('user-email-display').innerText = user.email;
        
        // עצירת תהליך אם המשתמש ממתין לאישור
        if (userStatus === 'pending') {
            document.getElementById('pending-user-email').innerText = user.email;
            showScreen('pending-screen');
            return;
        }

        // אם המשתמש הוא מנהל מערכת, נטען את פאנל האישורים
        if (userStatus === 'admin') {
            document.getElementById('admin-panel').classList.remove('hidden');
            loadPendingUsers();
        }

    } catch(e) { 
        console.warn("שגיאה בשלב האתחול המאובטח", e); 
    }
    
    await loadUserCars(true);
}

// פונקציות ניהול לאדמין
async function loadPendingUsers() {
    const container = document.getElementById('admin-pending-list');
    const { data: pendingUsers } = await supabaseClient.from('profiles').select('*').eq('status', 'pending');
    
    if (!pendingUsers || pendingUsers.length === 0) {
        container.innerHTML = 'אין בקשות הצטרפות ממתינות.';
        return;
    }
    
    container.innerHTML = '';
    pendingUsers.forEach(u => {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; background:white; padding:8px; border-radius:6px;';
        div.innerHTML = `
            <div><strong>${u.display_name || 'אנונימי'}</strong> (${u.email})</div>
            <button onclick="approveUser('${u.id}')" class="success" style="width:auto; margin:0; padding:4px 10px; font-size:0.8rem;">אשר גישה</button>
        `;
        container.appendChild(div);
    });
}

async function approveUser(userId) {
    const { error } = await supabaseClient.from('profiles').update({ status: 'approved' }).eq('id', userId);
    if (error) alert("שגיאה באישור המשתמש: " + error.message);
    else {
        alert("המשתמש אושר בהצלחה!");
        loadPendingUsers();
    }
}

async function editDisplayName() {
    const currentName = document.getElementById('user-display-name').innerText;
    const newName = prompt("הכנס כינוי חדש שיופיע לשותפות שלך:", currentName);
    if (newName && newName.trim() !== "") {
        await supabaseClient.from('profiles').update({ display_name: newName.trim() }).eq('id', currentUser.id);
        document.getElementById('user-display-name').innerText = newName.trim();
        if(currentCar) loadDashboardData();
    }
}

async function loadUserCars(isInitialLogin = false) {
    const listDiv = document.getElementById('my-cars-list');
    listDiv.innerHTML = 'טוען רכבים...';

    try {
        const { data: invites } = await supabaseClient.from('invitations').select('*').eq('invited_email', currentUser.email.toLowerCase());
        if (invites && invites.length > 0) {
            for (let inv of invites) {
                await supabaseClient.from('group_members').upsert({ group_id: inv.group_id, user_id: currentUser.id });
                await supabaseClient.from('invitations').delete().eq('id', inv.id);
            }
        }
    } catch(e) {}

    const { data: members, error } = await supabaseClient.from('group_members').select(`group_id, car_groups (id, name, initial_odo)`).eq('user_id', currentUser.id);
    if (error) { listDiv.innerHTML = 'שגיאה: ' + error.message; showScreen('cars-screen'); return; }
    
    const validMembers = (members || []).filter(m => m.car_groups);

    // מעקף חכם: אם יש למשתמש רק רכב אחד, נכנסים אליו ישירות בלי להציג את מסך הרשימה
    if (isInitialLogin && validMembers.length === 1 && !currentCar) {
        enterCar(validMembers[0].car_groups);
        return;
    }

    if (validMembers.length === 0) {
        listDiv.innerHTML = '<p>אין לך רכבים. צרי רכב חדש או בקשי הזמנה משותפה.</p>';
    } else {
        listDiv.innerHTML = '';
        validMembers.forEach(member => {
            const div = document.createElement('div');
            div.className = 'car-list-item';
            
            const infoDiv = document.createElement('div');
            infoDiv.style.flex = "1";
            infoDiv.innerHTML = `<strong>${member.car_groups.name || 'רכב ללא שם'}</strong>`;
            infoDiv.onclick = () => enterCar(member.car_groups);
            
            const btnDiv = document.createElement('div');
            const delBtn = document.createElement('button');
            delBtn.className = 'danger';
            delBtn.style.cssText = 'width: auto; padding: 5px 10px; margin: 0; font-size: 0.8rem;';
            delBtn.innerText = 'מחק רכב';
            delBtn.onclick = (e) => { e.stopPropagation(); leaveCar(member.group_id); };
            btnDiv.appendChild(delBtn);
            
            div.appendChild(infoDiv);
            div.appendChild(btnDiv);
            listDiv.appendChild(div);
        });
    }
    showScreen('cars-screen');
}

async function leaveCar(groupId) {
    if(confirm("האם את בטוחה שאת רוצה למחוק/לעזוב את הרכב הזה?")) {
        await supabaseClient.from('group_members').delete().match({ group_id: groupId, user_id: currentUser.id });
        loadUserCars();
    }
}

function showCreateCarForm() { document.getElementById('create-car-form').classList.remove('hidden'); }
function hideCreateCarForm() { document.getElementById('create-car-form').classList.add('hidden'); }

async function createCar() {
    const name = document.getElementById('new-car-name').value;
    const initialOdo = document.getElementById('new-car-odo').value;
    if (!name || !initialOdo) return alert("חסרים פרטים");
    
    const { data: newCar } = await supabaseClient.from('car_groups').insert({ name: name, initial_odo: parseFloat(initialOdo) }).select().single();
    await supabaseClient.from('group_members').insert({ group_id: newCar.id, user_id: currentUser.id });
    hideCreateCarForm();
    loadUserCars();
}

function enterCar(carObj) {
    currentCar = carObj;
    document.getElementById('active-car-name').innerText = carObj.name || 'רכב';
    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
    showScreen('app-screen');
}

function backToCars() {
    currentCar = null;
    currentCarMembers = [];
    document.getElementById('whatsapp-share-container').classList.add('hidden');
    loadUserCars();
}

function prepareTripForm() {
    document.getElementById('current-odo-hint').innerText = `מד אוץ קודם מחושב: ${calculatedOdometer.toFixed(0)}`;
    const participantsDiv = document.getElementById('trip-participants-list');
    participantsDiv.innerHTML = '';
    
    currentCarMembers.forEach(m => {
        const isMe = m.profiles.id === currentUser.id;
        participantsDiv.innerHTML += `
            <div class="checkbox-item">
                <input type="checkbox" id="part-${m.profiles.id}" value="${m.profiles.id}" ${isMe ? 'checked' : ''}>
                <label for="part-${m.profiles.id}" style="margin:0; font-weight:normal;">${isMe ? 'אני (את/ה)' : m.profiles.display_name}</label>
            </div>
        `;
    });
}

async function prepareRefuelForm() {
    document.getElementById('refuel-odo-hint').innerText = `מד אוץ משוער נוכחי: ${calculatedOdometer.toFixed(0)}`;
    
    const { data: lastRefuels } = await supabaseClient.from('refuels').select('odometer').eq('group_id', currentCar.id).order('created_at', { ascending: false }).limit(1);
    if (lastRefuels && lastRefuels.length > 0) {
        document.getElementById('prev-refuel-odo-display').innerText = `מד אוץ בתדלוק הקודם: ${Number(lastRefuels[0].odometer).toFixed(0)}`;
    } else {
        document.getElementById('prev-refuel-odo-display').innerText = `מד אוץ בתדלוק הקודם: אין (משתמש במד אוץ התחלתי: ${Number(currentCar.initial_odo).toFixed(0)})`;
    }
    
    const refuelPartsDiv = document.getElementById('refuel-participants-list');
    refuelPartsDiv.innerHTML = '';
    
    currentCarMembers.forEach(m => {
        const isMe = m.profiles.id === currentUser.id;
        refuelPartsDiv.innerHTML += `
            <div class="checkbox-item">
                <input type="checkbox" id="refuel-part-${m.profiles.id}" value="${m.profiles.id}" ${isMe ? 'checked' : ''}>
                <label for="refuel-part-${m.profiles.id}" style="margin:0; font-weight:normal;">${isMe ? 'אני (את/ה)' : m.profiles.display_name}</label>
            </div>
        `;
    });
}

function showSettleForm() {
    let options = '<option value="">בחרי למי להעביר</option>';
    currentCarMembers.forEach(m => {
        if(m.profiles.id !== currentUser.id) {
            options += `<option value="${m.profiles.id}">${m.profiles.display_name}</option>`;
        }
    });
    document.getElementById('settle-paid-to').innerHTML = options;
    document.getElementById('settle-form-container').classList.remove('hidden');
}

function hideSettleForm() {
    document.getElementById('settle-form-container').classList.add('hidden');
    document.getElementById('settle-amount').value = '';
}

async function submitSettlement() {
    const paidTo = document.getElementById('settle-paid-to').value;
    const amount = parseFloat(document.getElementById('settle-amount').value);
    
    if(!paidTo || !amount || amount <= 0) return alert("נא לבחור שותפה ולהזין סכום תקין");
    
    const { error } = await supabaseClient.from('settlements').insert({
        group_id: currentCar.id, paid_by: currentUser.id, paid_to: paidTo, amount: amount, note: "העברה ידנית"
    });
    
    if(error) return alert("שגיאה: " + error.message);
    alert("העברת הכסף נשמרה!");
    hideSettleForm();
    loadDashboardData();
}

// אלגוריתם איפוס חובות אוטומטי (Compensating Settlements)
async function triggerResetAllBalances() {
    if (!confirm("האם את בטוחה שברצונך לאפס את כל החובות הנוכחיים ברכב?\nהפעולה תייצר העברות מקזזות אוטומטיות שיביאו את כולם ל-0 ₪.")) return;
    
    let debtors = [];  // מי שבמינוס (חייב כסף)
    let creditors = []; // מי שבפלוס (מגיע לו כסף)
    
    for (let id in userBalancesGlobal) {
        let bal = userBalancesGlobal[id];
        if (bal < -0.99) debtors.push({ id: id, amount: Math.abs(bal) });
        else if (bal > 0.99) creditors.push({ id: id, amount: bal });
    }
    
    if (debtors.length === 0 && creditors.length === 0) {
        alert("הקופה כבר מאופסת לחלוטין!");
        return;
    }
    
    try {
        let recordsToInsert = [];
        let dIdx = 0, cIdx = 0;
        
        while (dIdx < debtors.length && cIdx < creditors.length) {
            let debtor = debtors[dIdx];
            let creditor = creditors[cIdx];
            
            let settleAmount = Math.min(debtor.amount, creditor.amount);
            
            recordsToInsert.push({
                group_id: currentCar.id,
                paid_by: debtor.id, // החייב מעביר כסף
                paid_to: creditor.id, // למי שמגיע לו
                amount: parseFloat(settleAmount.toFixed(2)),
                note: "איפוס חובות תקופתי"
            });
            
            debtor.amount -= settleAmount;
            creditor.amount -= settleAmount;
            
            if (debtor.amount <= 0.05) dIdx++;
            if (creditor.amount <= 0.05) cIdx++;
        }
        
        if (recordsToInsert.length > 0) {
            const { error } = await supabaseClient.from('settlements').insert(recordsToInsert);
            if(error) throw error;
        }
        
        alert("כל החובות אופסו וסונכרנו בהצלחה!");
        loadDashboardData();
    } catch(e) {
        alert("שגיאה בתהליך האיפוס: " + e.message);
    }
}

// טעינה ועיבוד אנליטי של הדשבורד
async function loadDashboardData() {
    if(!currentCar) return;

    const [refuels, trips, members, participants, settlements] = await Promise.all([
        supabaseClient.from('refuels').select('*').eq('group_id', currentCar.id).order('created_at', { ascending: false }),
        supabaseClient.from('trips').select('*').eq('group_id', currentCar.id).order('created_at', { ascending: false }),
        supabaseClient.from('group_members').select('profiles(id, display_name, email)').eq('group_id', currentCar.id),
        supabaseClient.from('trip_participants').select('*'),
        supabaseClient.from('settlements').select('*').eq('group_id', currentCar.id).order('created_at', { ascending: false })
    ]);

    currentCarMembers = (members.data || []).filter(m => m && m.profiles);
    const safeRefuels = refuels.data || [];
    const safeTrips = trips.data || [];
    const safeParticipants = participants.data || [];
    const safeSettlements = settlements.data || [];

    // הצגת רשימת שותפות
    const membersHTML = currentCarMembers.map(m => {
        const p = m.profiles;
        return p.id === currentUser.id 
            ? `<div style="margin-bottom:5px;"><strong style="color:var(--primary);">את/ה</strong> <span style="font-size:0.85em; color:var(--text-light);">(${p.display_name})</span></div>`
            : `<div style="margin-bottom:5px;"><strong>${p.display_name}</strong> <span style="font-size:0.85em; color:var(--text-light); direction:ltr; display:inline-block;">(${p.email})</span></div>`;
    }).join('');
    document.getElementById('dash-members-list').innerHTML = membersHTML;

    // חישוב מד אוץ
    let lastRefuelOdo = safeRefuels.length > 0 ? Number(safeRefuels[0].odometer) : Number(currentCar.initial_odo);
    let tripsSinceRefuel = 0;
    const lastRefuelDate = safeRefuels.length > 0 ? new Date(safeRefuels[0].created_at) : new Date(0);
    
    safeTrips.forEach(t => {
        if(new Date(t.created_at) > lastRefuelDate) {
            tripsSinceRefuel += Number(t.distance);
        }
    });
    calculatedOdometer = lastRefuelOdo + tripsSinceRefuel;
    document.getElementById('dash-current-odo').innerText = calculatedOdometer.toFixed(0);

    // חישוב הוצאות וחלוקת מרחקים
    let totalCost = 0, totalTripsKm = 0;
    let paymentsByUser = {}, kmByUser = {};

    currentCarMembers.forEach(m => {
        paymentsByUser[m.profiles.id] = { fuelPaid: 0, setPaid: 0, setReceived: 0 };
        kmByUser[m.profiles.id] = { km: 0 };
        userBalancesGlobal[m.profiles.id] = 0;
    });

    safeRefuels.forEach(r => {
        totalCost += Number(r.cost);
        if(paymentsByUser[r.paid_by]) paymentsByUser[r.paid_by].fuelPaid += Number(r.cost);
    });

    safeSettlements.forEach(s => {
        if(paymentsByUser[s.paid_by]) paymentsByUser[s.paid_by].setPaid += Number(s.amount);
        if(paymentsByUser[s.paid_to]) paymentsByUser[s.paid_to].setReceived += Number(s.amount);
    });

    safeTrips.forEach(t => {
        totalTripsKm += Number(t.distance);
        let tripParts = safeParticipants.filter(p => p.trip_id === t.id);
        if(tripParts.length > 0) {
            let splitDistance = Number(t.distance) / tripParts.length;
            tripParts.forEach(p => {
                if(kmByUser[p.user_id]) kmByUser[p.user_id].km += splitDistance;
            });
        } else {
            if(kmByUser[t.recorded_by]) kmByUser[t.recorded_by].km += Number(t.distance);
        }
    });

    let avgCostPerKm = totalTripsKm > 0 ? (totalCost / totalTripsKm) : 0;
    document.getElementById('dash-total-cost').innerText = `₪${totalCost.toFixed(0)}`;
    document.getElementById('dash-avg-cost').innerText = totalTripsKm > 0 ? `₪${avgCostPerKm.toFixed(2)}` : '0';
    document.getElementById('dash-total-km').innerText = totalTripsKm.toFixed(1);

    // 1. טבלת מצב קופה (RTL)
    let balanceHTML = '<table><tr><th>שותפה</th><th>מצב כולל</th><th>שילמה דלק</th><th>נסעה (ק"מ)</th></tr>';
    currentCarMembers.forEach(m => {
        let id = m.profiles.id;
        let name = id === currentUser.id ? 'את/ה' : m.profiles.display_name;
        let km = kmByUser[id] ? kmByUser[id].km : 0;
        let fPaid = paymentsByUser[id] ? paymentsByUser[id].fuelPaid : 0;
        let sPaid = paymentsByUser[id] ? paymentsByUser[id].setPaid : 0;
        let sRec = paymentsByUser[id] ? paymentsByUser[id].setReceived : 0;
        
        let finalBalance = fPaid - (km * avgCostPerKm) + sPaid - sRec;
        userBalancesGlobal[id] = finalBalance; // עדכון גלובלי לאיפוס
        
        let color = finalBalance >= 0 ? 'var(--success)' : 'var(--danger)';
        balanceHTML += `<tr>
            <td><strong>${name}</strong></td>
            <td style="color:${color}; font-weight:bold; direction:ltr; text-align:right;">${finalBalance > 0 ? '+' : ''}${finalBalance.toFixed(0)}₪</td>
            <td>₪${fPaid.toFixed(0)}</td>
            <td>${km.toFixed(1)}</td>
        </tr>`;
    });
    balanceHTML += '</table>';
    document.getElementById('dash-balances').innerHTML = totalTripsKm > 0 ? balanceHTML : '<p>אין מספיק נתונים לחישוב.</p>';

    // 2. טבלת קיזוזים (RTL)
    let setHTML = '<table><tr><th>תאריך</th><th>מעבירה</th><th>מקבלת</th><th>סכום</th><th>סוג פעולה</th></tr>';
    safeSettlements.slice(0, 5).forEach(s => {
        let by = currentCarMembers.find(m => m.profiles.id === s.paid_by)?.profiles?.display_name || 'אנונימית';
        let to = currentCarMembers.find(m => m.profiles.id === s.paid_to)?.profiles?.display_name || 'אנונימית';
        let date = new Date(s.created_at).toLocaleDateString('he-IL');
        setHTML += `<tr><td>${date}</td><td>${s.paid_by===currentUser.id?'את/ה':by}</td><td>${s.paid_to===currentUser.id?'את/ה':to}</td><td>₪${s.amount}</td><td><span style="font-size:0.8em;color:var(--text-light);">${s.note || ''}</span></td></tr>`;
    });
    setHTML += '</table>';
    document.getElementById('dash-settlements-list').innerHTML = safeSettlements.length > 0 ? setHTML : '<p>אין העברות כספים.</p>';

    // 3. טבלת תדלוקים משודרגת אנליטית (RTL)
    let refuelsHTML = '<table><tr><th>תאריך</th><th>מתדלקת</th><th>עלות</th><th>ליטרים</th><th>₪ לליטר</th><th>ק"מ בטנק</th><th>₪ לק"מ</th><th>מד אוץ</th></tr>';
    safeRefuels.slice(0, 5).forEach((r, idx) => {
        let date = new Date(r.created_at).toLocaleDateString('he-IL');
        let name = r.paid_by === currentUser.id ? 'את/ה' : (currentCarMembers.find(m => m.profiles.id === r.paid_by)?.profiles?.display_name || '');
        let pricePerLiter = r.cost / r.liters;
        
        // חישוב המרחק שנעשה על מכל הדלק הספציפי הזה
        let prevOdo = (idx === safeRefuels.length - 1) ? Number(currentCar.initial_odo) : Number(safeRefuels[idx + 1].odometer);
        let tankKm = r.odometer - prevOdo;
        let costPerKmInTank = tankKm > 0 ? (r.cost / tankKm) : 0;

        refuelsHTML += `<tr>
            <td>${date}</td><td>${name}</td><td>₪${r.cost}</td><td>${r.liters}</td>
            <td>₪${pricePerLiter.toFixed(2)}</td><td>${tankKm > 0 ? tankKm.toFixed(0) : '-'}</td>
            <td>${tankKm > 0 ? '₪' + costPerKmInTank.toFixed(2) : '-'}</td><td>${r.odometer}</td>
        </tr>`;
    });
    refuelsHTML += '</table>';
    document.getElementById('dash-refuels-list').innerHTML = safeRefuels.length > 0 ? refuelsHTML : '<p>אין תדלוקים.</p>';

    // 4. טבלת נסיעות כולל שותפות (RTL)
    let tripsHTML = '<table><tr><th>תאריך</th><th>נהגת</th><th>מרחק</th><th>מד אוץ</th><th>שותפות</th><th>הערה</th></tr>';
    safeTrips.slice(0, 6).forEach(t => {
        let date = new Date(t.created_at).toLocaleDateString('he-IL', {day: '2-digit', month: '2-digit'});
        let name = t.recorded_by === currentUser.id ? 'את/ה' : (currentCarMembers.find(m => m.profiles.id === t.recorded_by)?.profiles?.display_name || '');
        
        // מציאת השותפות לנסיעה
        let tParts = safeParticipants.filter(p => p.trip_id === t.id);
        let partsNames = tParts.map(p => {
            if(p.user_id === currentUser.id) return "את/ה";
            return currentCarMembers.find(m => m.profiles.id === p.user_id)?.profiles?.display_name || "שותפה";
        }).join(', ');

        tripsHTML += `<tr>
            <td>${date}</td><td>${name}</td><td>${t.distance} ק"מ</td><td>${t.end_odo ? Math.round(t.end_odo) : '-'}</td>
            <td><span style="font-size:0.8em; color:var(--primary);">${tParts.length > 1 ? '👥 ' + partsNames : 'לבדה'}</span></td>
            <td>${t.note || '-'}</td>
        </tr>`;
    });
    tripsHTML += '</table>';
    document.getElementById('dash-trips-list').innerHTML = safeTrips.length > 0 ? tripsHTML : '<p>אין נסיעות.</p>';
}

async function saveTrip() {
    const distanceInput = document.getElementById('trip-distance').value.trim();
    const endOdoInput = document.getElementById('trip-end-odo').value.trim();
    
    let distance = 0; let endOdo = null;
    
    if (endOdoInput !== "") {
        endOdo = parseFloat(endOdoInput);
        if (endOdo < calculatedOdometer && !confirm(`מד האוץ שהזנת (${endOdo}) נמוך מהמד המחושב המעודכן (${calculatedOdometer.toFixed(0)}). להמשיך?`)) return;
        distance = endOdo - calculatedOdometer;
        if (distance < 0) distance = 0;
    } else if (distanceInput !== "") {
        distance = parseFloat(distanceInput);
        if (distance <= 0) return alert("הזני מרחק תקין");
        endOdo = calculatedOdometer + distance;
    } else {
        return alert("אנא הזיני מרחק או מד אוץ סופי.");
    }

    if (distance > 200 && !confirm("המרחק שהוזן גבוה מ-200 ק\"מ. האם את בטוחה?")) return;

    let selectedParticipants = [];
    currentCarMembers.forEach(m => {
        if(document.getElementById(`part-${m.profiles.id}`)?.checked) selectedParticipants.push(m.profiles.id);
    });
    if(selectedParticipants.length === 0) return alert("חייבת לבחור לפחות נוסעת אחת");

    const { data: newTrip, error } = await supabaseClient.from('trips').insert({ 
        group_id: currentCar.id, recorded_by: currentUser.id, distance: distance, end_odo: endOdo, note: document.getElementById('trip-note').value.trim()
    }).select().single();

    if (error) return alert("שגיאה: " + error.message);
    
    const pData = selectedParticipants.map(uid => ({ trip_id: newTrip.id, user_id: uid }));
    await supabaseClient.from('trip_participants').insert(pData);

    alert("הנסיעה נרשמה!");
    document.getElementById('trip-distance').value = ''; document.getElementById('trip-end-odo').value = ''; document.getElementById('trip-note').value = '';
    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
}

async function saveRefuel() {
    const cost = parseFloat(document.getElementById('refuel-cost').value);
    const liters = parseFloat(document.getElementById('refuel-liters').value);
    const odo = parseFloat(document.getElementById('refuel-odo').value);

    if (!cost || !liters || !odo) return alert("נא למלא את כל השדות");
    
    let gap = odo - calculatedOdometer;
    if(gap > 0.5) { 
        if(confirm(`זיהינו פער של ${gap.toFixed(1)} ק"מ (קילומטרים אבודים).\nהאם להוסיף את הפער אוטומטית כ"נסיעה לתחנה" ולחלק בין המשתתפות המסומנות?`)) {
            let selectedParticipants = [];
            currentCarMembers.forEach(m => {
                if(document.getElementById(`refuel-part-${m.profiles.id}`)?.checked) selectedParticipants.push(m.profiles.id);
            });
            if(selectedParticipants.length === 0) selectedParticipants.push(currentUser.id);

            const { data: newTrip } = await supabaseClient.from('trips').insert({ 
                group_id: currentCar.id, recorded_by: currentUser.id, distance: gap, end_odo: odo, note: "נסיעה לתחנה (ק"מ אבודים)" 
            }).select().single();
            
            if(newTrip) {
                await supabaseClient.from('trip_participants').insert(selectedParticipants.map(uid => ({ trip_id: newTrip.id, user_id: uid })));
            }
        }
    } else if(gap < -0.5 && !confirm(`מד האוץ שהזנת נמוך מהחישוב ברקע. להמשיך?`)) return;

    const { error } = await supabaseClient.from('refuels').insert({ group_id: currentCar.id, paid_by: currentUser.id, cost: cost, liters: liters, odometer: odo });
    if (error) return alert("שגיאה: " + error.message);
    
    alert("התדלוק נשמר!");
    document.getElementById('refuel-cost').value = ''; document.getElementById('refuel-liters').value = ''; document.getElementById('refuel-odo').value = '';
    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
}

async function inviteUser() {
    const email = document.getElementById('invite-email').value.toLowerCase().trim();
    if (!email) return alert("הזיני מייל");
    const { error } = await supabaseClient.from('invitations').insert({ group_id: currentCar.id, invited_email: email, invited_by: currentUser.id });
    if (error) alert("שגיאה: " + error.message);
    else {
        alert("הזמנה נשמרה בהצלחה במערכת.");
        document.getElementById('invite-email').value = '';
        document.getElementById('whatsapp-share-container').classList.remove('hidden');
    }
}

function shareWhatsApp() {
    const text = encodeURIComponent(`היי! צירפתי אותך לרכב באפליקציית הדלק שלנו 🚗\nהיכנסי לקישור הבא והתחברי עם הג'ימייל שלך:\n${window.location.origin}`);
    window.open(`https://wa.me/?text=${text}`, '_blank');
}

// ניהול אירועים מבוקר למניעת כפילויות רענון
supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session && session.user) {
        if (!currentUser || currentUser.id !== session.user.id) {
            initializeApp(session.user);
        }
    } else {
        currentUser = null; currentCar = null;
        showScreen('login-screen');
    }
});
